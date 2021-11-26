import fastify from 'fastify';
import configs from "./wasmception-config";
import { mkdirSync, writeFileSync, existsSync, openSync, closeSync, readFileSync, unlinkSync, fstat } from "fs";
import { deflateSync } from "zlib";
import { dirname } from "path";
import { execSync } from "child_process";
import { z } from 'zod';
import fastifyCors from 'fastify-cors';
import fastifyWebSocket from 'fastify-websocket';
import * as ws from 'ws';
import * as rpc from 'vscode-ws-jsonrpc';
import * as rpcServer from 'vscode-ws-jsonrpc/lib/server';

const server = fastify();

server.register(fastifyCors, {
  // put your options here
  origin: '*'
})
server.register(fastifyWebSocket);

// Compilation code
const { llvmDir, tempDir, sysroot } = configs;

export interface ResponseData {
  success: boolean;
  message: string;
  output: string;
  tasks: Task[];
}

export interface Task {
  name: string;
  file?: string;
  success?: boolean;
  console?: string;
  output?: string;
}

const requestBodySchema = z.object({
  output: z.enum(['wasm']),
  files: z.array(z.object({
    type: z.string(),
    name: z.string(),
    options: z.string().optional(),
    src: z.string()
  })),
  link_options: z.string().optional(),
  compress: z.boolean().optional()
});

type RequestBody = z.infer<typeof requestBodySchema>;

// Input: JSON in the following format
// {
//     output: "wasm",
//     files: [
//         {
//             type: "cpp",
//             name: "file.cpp",
//             options: "-O3 -std=c++98",
//             src: "puts(\"hi\")"
//         }
//     ],
//     link_options: "--import-memory"
// }
// Output: JSON in the following format
// {
//     success: true,
//     message: "Success",
//     output: "AGFzbQE.... =",
//     tasks: [
//         {
//             name: "building file.cpp",
//             file: "file.cpp",
//             success: true,
//             console: ""
//         },
//         {
//             name: "linking wasm",
//             success: true,
//             console: ""
//         }
//     ]
// }

function sanitize_shell_output<T>(out: T): T {
  return out; // FIXME
}

function shell_exec(cmd: string, cwd = tempDir) {
  const out = openSync(cwd + '/out.log', 'w');
  let error = '';
  try {
    execSync(cmd, { cwd, stdio: [null, out, out], });
  } catch (ex: unknown) {
    if (ex instanceof Error) {
      error = ex?.message;
    }
  } finally {
    closeSync(out);
  }
  const result = readFileSync(cwd + '/out.log').toString() || error;
  return result;
}

function get_clang_options(options: string) {
  const clang_flags = `--target=wasm32-unknown-unknown-wasm --sysroot=${sysroot} -I/app/clang/includes -fdiagnostics-print-source-range-info -fno-exceptions`;
  if (!options) {
    return clang_flags;
  }
  const available_options = [
    '-O0', '-O1', '-O2', '-O3', '-O4', '-Os', '-fno-exceptions', '-fno-rtti',
    '-ffast-math', '-fno-inline', '-std=c99', '-std=c89', '-std=c++14',
    '-std=c++1z', '-std=c++11', '-std=c++98', '-g'
  ];
  let safe_options = '-c';
  for (let o of available_options) {
    if (options.includes(o)) {
      safe_options += ' ' + o;
    } else if (o.includes('-std=') && options.toLowerCase().includes(o)) {
      safe_options += ' ' + o;
    }
  }
  return clang_flags + ' ' + safe_options;
}


function get_lld_options(options: string) {
  const clang_flags = `--target=wasm32-unknown-unknown-wasm --sysroot=${sysroot} -nostartfiles -Wl,--allow-undefined,--no-entry,--no-threads`;
  if (!options) {
    return clang_flags;
  }
  const available_options = ['--import-memory', '-g'];
  let safe_options = '';
  for (let o of available_options) {
    if (options.includes(o)) {
      safe_options += ' -Wl,' + o;
    }
  }
  return clang_flags + safe_options;
}

function serialize_file_data(filename: string, compress: boolean) {
  let content = readFileSync(filename);
  if (compress) {
    content = deflateSync(content);
  }
  return content.toString("base64");
}

function build_c_file(input: string, options: string, output: string, cwd: string, compress: boolean, result_obj: Task) {
  const cmd = llvmDir + '/bin/clang ' + get_clang_options(options) + ' ' + input + ' -o ' + output;
  const out = shell_exec(cmd, cwd);
  result_obj.console = sanitize_shell_output(out);
  if (!existsSync(output)) {
    result_obj.success = false;
    return false;
  }
  result_obj.success = true;
  result_obj.output = serialize_file_data(output, compress);
  return true;
}

function build_cpp_file(input: string, options: string, output: string, cwd: string, compress: boolean, result_obj: Task) {
  const cmd = llvmDir + '/bin/clang++ ' + get_clang_options(options) + ' ' + input + ' -o ' + output;
  const out = shell_exec(cmd, cwd);
  result_obj.console = sanitize_shell_output(out);
  if (!existsSync(output)) {
    result_obj.success = false;
    return false;
  }
  result_obj.success = true;
  result_obj.output = serialize_file_data(output, compress);
  return true;
}

function validate_filename(name: string) {
  if (!/^[0-9a-zA-Z\-_.]+(\/[0-9a-zA-Z\-_.]+)*$/.test(name)) {
    return false;
  }
  const parts = name.split(/\//g);
  for (let p of parts) {
    if (p == '.' || p == '..') {
      return false;
    }
  }
  return parts;
}

function link_obj_files(obj_files: string[], options: string, cwd: string, has_cpp: boolean | undefined, output: string, result_obj: Task) {
  const files = obj_files.join(' ');
  let clang;
  if (has_cpp) {
    clang = llvmDir + '/bin/clang++';
  } else {
    clang = llvmDir + '/bin/clang';
  }
  const cmd = clang + ' ' + get_lld_options(options) + ' ' + files + ' -o ' + output;
  const out = shell_exec(cmd, cwd);
  result_obj.console = sanitize_shell_output(out);
  if (!existsSync(output)) {
    result_obj.success = false;
    return false;
  }
  result_obj.success = true;
  return true;
}

function build_project(project: RequestBody, base: string) {
  const output = project.output;
  const compress = project.compress;
  let build_result: ResponseData = {
    success: false,
    message: '',
    output: '',
    tasks: [],
  };
  const dir = base + '.$';
  const result = base + '.wasm';

  const complete = (success: boolean, message: string) => {
    shell_exec("rm -rf " + dir);
    if (existsSync(result)) {
      unlinkSync(result);
    }

    build_result.success = success;
    build_result.message = message;
    return build_result;
  };

  if (output != 'wasm') {
    return complete(false, 'Invalid output type ' + output);
  }

  if (!existsSync(dir)) {
    mkdirSync(dir);
  }
  build_result.tasks = [];
  const files = project.files;
  for (let file of files) {
    const name = file.name;
    if (!validate_filename(name)) {
      return complete(false, 'Invalid filename ' + name);
    }
    const fileName = dir + '/' + name;
    const subdir = dirname(fileName);
    if (!existsSync(subdir)) {
      mkdirSync(dir);
    }
    const src = file.src;
    writeFileSync(fileName, src);
  }
  const obj_files = [];
  let clang_cpp = false;
  for (let file of files) {
    const name = file.name;
    const fileName = dir + '/' + name;
    const type = file.type;
    const options = file.options;
    let success = true;
    const result_obj = {
      name: `building ${name}`,
      file: name
    };
    build_result.tasks.push(result_obj);
    if (type == 'c') {
      success = build_c_file(fileName, options || '', fileName + '.o', dir, compress || false, result_obj);

      obj_files.push(fileName + '.o');
    } else if (type == 'cpp') {
      clang_cpp = true;
      success = build_cpp_file(fileName, options || '', fileName + '.o', dir, compress || false, result_obj);
      obj_files.push(fileName + '.o');
    }
    if (!success) {
      return complete(false, 'Error during build of ' + name);
    }
  }
  const link_options = project.link_options;
  const link_result_obj = {
    name: 'linking wasm'
  };
  build_result.tasks.push(link_result_obj);
  if (!link_obj_files(obj_files, link_options || '', dir, clang_cpp, result, link_result_obj)) {
    return complete(false, 'Error during linking');
  }

  build_result.output = serialize_file_data(result, compress || false);

  return complete(true, 'Success');
}
// END Compile code

server.post('/api/build', async (req, reply) => {
  // Bail out early if not HTTP POST
  if (req.method !== 'POST') {
    return reply.code(405).send('405 Method Not Allowed');
  }
  const baseName = tempDir + '/build_' + Math.random().toString(36).slice(2);
  let body: RequestBody | undefined;
  try {
    body = requestBodySchema.parse(req.body);
  } catch (err) {
    console.log(err)
    return reply.code(400).send('400 Bad Request')
  }
  try {
    console.log('Building in ', baseName);
    const result = build_project(body, baseName);
    return reply.code(200).send(result);
  } catch (ex) {
    return reply.code(500).send('500 Internal server error')
  }
  // return reply.code(200).send({ hello: 'world' });
});

server.get('/', async (req, reply) => {
  reply.code(200).send('ok')
})

function toSocket(webSocket: ws): rpc.IWebSocket {
  return {
    send: content => webSocket.send(content),
    onMessage: cb => webSocket.onmessage = event => cb(event.data),
    onError: cb => webSocket.onerror = event => {
      if ('message' in event) {
        cb((event as any).message)
      }
    },
    onClose: cb => webSocket.onclose = event => cb(event.code, event.reason),
    dispose: () => webSocket.close()
  }
}

server.get('/language-server/c', { websocket: true }, (connection /* SocketStream */, req /* FastifyRequest */) => {
  let localConnection = rpcServer.createServerProcess('Example', 'clangd', []);
  let socket: rpc.IWebSocket = toSocket(connection.socket);
  let newConnection = rpcServer.createWebSocketConnection(socket);
  rpcServer.forward(newConnection, localConnection);
  console.log(`Forwarding new client`);
  socket.onClose((code, reason) => {
    console.log('Client closed', reason);
    localConnection.dispose();
  });
  // connection.socket.on('message', message => {
  //   // message.toString() === 'hi from client'
  //   connection.socket.send('hi from server')
  // })
})

server.listen(process.env.PORT || 9000, process.env.HOST || '::', (err, address) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`Server listening at ${address}`)
});