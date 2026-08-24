/** Exact launcher bytes shared by the offline bundle builder and verifier. */
export const OFFLINE_LAUNCHERS = Object.freeze({
  "bin/stinky-cobbler": Object.freeze({
    contents: "#!/bin/sh\nexec node \"$(dirname \"$0\")/../package/dist/cli.js\" \"$@\"\n",
    executable: true
  }),
  "bin/stinky-cobbler-mcp": Object.freeze({
    contents: "#!/bin/sh\nexec node \"$(dirname \"$0\")/../package/dist/mcp-server.js\" \"$@\"\n",
    executable: true
  }),
  "bin/stinky-cobbler.cmd": Object.freeze({
    contents: "@echo off\r\nnode \"%~dp0\\..\\package\\dist\\cli.js\" %*\r\n",
    executable: false
  }),
  "bin/stinky-cobbler-mcp.cmd": Object.freeze({
    contents: "@echo off\r\nnode \"%~dp0\\..\\package\\dist\\mcp-server.js\" %*\r\n",
    executable: false
  })
});
