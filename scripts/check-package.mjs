import { execFileSync } from "node:child_process";

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
const [pack] = JSON.parse(output);
if (!pack || pack.name !== "agentsnippet") {
  throw new Error("Packed npm artifact is not named agentsnippet.");
}

const files = pack.files.map((entry) => entry.path);
const forbidden = files.filter(
  (file) =>
    file === "plans" ||
    file.startsWith("plans/") ||
    file === "test" ||
    file.startsWith("test/") ||
    file === "src" ||
    file.startsWith("src/"),
);
if (forbidden.length > 0) {
  throw new Error(`Packed npm artifact contains repository-only files: ${forbidden.join(", ")}`);
}

for (const required of ["package.json", "dist/cli.js", "README.md", "LICENSE", "SPEC.md"]) {
  if (!files.includes(required)) throw new Error(`Packed npm artifact is missing ${required}.`);
}

const cli = pack.files.find((entry) => entry.path === "dist/cli.js");
if (!cli || (cli.mode & 0o111) === 0) {
  throw new Error("Packed dist/cli.js is not executable; npm would remove the bin entry on publish.");
}

console.log(`Package contents verified (${files.length} files, ${pack.size} bytes).`);
