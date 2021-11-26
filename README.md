# API that compiles C code to WASM

This repository contains proof of concept work for C to WASM compiler API.
Server is built with [Fastify](https://www.fastify.io/), fast and low overhead framework for Node.js

Compiling itself is done with Clang and the binaries for darwin and linux comes bundled with the project.

## Development

If you want to try this project follow these steps:

- Clone the repo: `git clone git@github.com:valstu/c2wasm-api.git`
- Install all the necessary dependenceies by running `yarn` or `yarn install` you can use npm as well
- After that you can start the server by running `yarn dev`

This should start server at port `:9000`, the actual compiling endpoint is this:
[http://localhost:9000/api/build](localhost:9000/api/build)

Endpoint only accepts `HTTP POST`.

You can send for example following payload to endpoint:

```json
{
  "output": "wasm",
  "compress": true,
  "files": [
    {
      "type": "c",
      "name": "file.c",
      "options": "-g -O3",
      "src": "#include <stdio.h>\n\nint main()\n{\n\n   printf(\"Hello World\");\n   return 0;\n}"
    }
  ]
}
```

Payload itself is quite self-explanatory, but the code you want to compile is under files arrays src property, you can also add some options for the compiler itself. When you POST this payload to the endpoint you should get back following response:

```json
{
  "success": true,
  "message": "Success",
  "output": "eJzUXQecVcXVv21uee/t7iv7...",
  "tasks": [
    {
      "name": "building file.c",
      "file": "file.c",
      "console": "",
      "success": true,
      "output": "eJx1UU2LE..."
    },
    {
      "name": "linking wasm",
      "console": "",
      "success": true
    }
  ]
}
```

Output contains compiled wasm file base64 encoded.

- TODO: Add information about compression and base64
- TODO: Add information about docker stuff

## Push to Heroku

Install Heroku CLI

- Login to Heroku: `heroku login`
- Login to Heroku Containers: `heroku container:login`
- Build and push the image to Heroku: `heroku container:push web -a arcane-inlet-17120`
- Release new version: ``
  Run following commands
