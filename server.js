import { createServerApplication } from "./src/server.js";

const application = createServerApplication();
const address = await application.listen();
const host = address.address === "::" ? "127.0.0.1" : address.address;
console.log(`FDEX Image Service: http://${host}:${address.port}`);
console.log(`Provider mode: ${application.config.providerMode}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await application.close();
    process.exit(0);
  });
}
