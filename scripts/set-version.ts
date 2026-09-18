const [version] = Deno.args;
if (version === undefined) {
  console.error("Usage: deno run --allow-read --allow-write scripts/set-version.ts <version>");
  Deno.exit(1);
}

const path = new URL("../deno.json", import.meta.url);
const config = JSON.parse(Deno.readTextFileSync(path));
config.version = version;
Deno.writeTextFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
