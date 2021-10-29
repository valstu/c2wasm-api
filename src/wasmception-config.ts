// const onServer = !!process.env["DYNO"];
// const homeDir = process.env["HOME"];
import os from 'os';
const wasmceptionDir = process.env["WASMCEPTION"] ||
  (process.cwd() + `/clang/wasmception-${os.platform().toLowerCase()}-bin`);
const sysroot = wasmceptionDir + '/sysroot';

const llvmDir = wasmceptionDir + '/dist';

const tempDir = "/tmp";

const configs = {
  sysroot,
  llvmDir,
  tempDir
}

export default configs
