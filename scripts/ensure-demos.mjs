// Creates an empty src/data/demos.json when missing. Recorded runs hold third-party content (web pages,
// event listings), so the file stays out of git and is shipped with the deployment instead.
import fs from "node:fs";
const file = new URL("../src/data/demos.json", import.meta.url);
if (!fs.existsSync(file)) fs.writeFileSync(file, "[]\n");
