import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceScript = readFileSync(new URL("./deploy-admin.sh", import.meta.url), "utf8");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(cacheControl: string) {
  const root = mkdtempSync(path.join(tmpdir(), "nailzify-admin-deploy-"));
  temporaryRoots.push(root);

  const scriptsDirectory = path.join(root, "scripts");
  const binDirectory = path.join(root, "bin");
  const logFile = path.join(root, "commands.log");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });

  const scriptPath = path.join(scriptsDirectory, "deploy-admin.sh");
  writeFileSync(scriptPath, sourceScript);

  const fakeNpm = path.join(binDirectory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "$DEPLOY_TEST_LOG"
mkdir -p "$PWD/web/admin/dist/assets"
printf 'javascript' > "$PWD/web/admin/dist/assets/index-test.js"
printf '<html></html>' > "$PWD/web/admin/dist/index.html"
`,
  );
  chmodSync(fakeNpm, 0o755);

  const fakeAws = path.join(binDirectory, "aws");
  writeFileSync(
    fakeAws,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >> "$DEPLOY_TEST_LOG"
if [[ "$1" == "s3api" && "$2" == "head-object" ]]; then
  printf '%s\n' "$FAKE_CACHE_CONTROL"
elif [[ "$1" == "cloudfront" && "$2" == "list-distributions" ]]; then
  printf 'EDIST123\n'
fi
`,
  );
  chmodSync(fakeAws, 0o755);

  return {
    logFile,
    run: (...args: string[]) =>
      spawnSync("bash", [scriptPath, ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_TEST_LOG: logFile,
          FAKE_CACHE_CONTROL: cacheControl,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        },
      }),
  };
}

describe("deploy-admin.sh", () => {
  it("builds, uploads assets first, and publishes index.html with safe cache metadata", () => {
    const fixture = makeFixture("no-cache, max-age=0, must-revalidate");

    const result = fixture.run();
    const commands = readFileSync(fixture.logFile, "utf8");

    expect(result.status).toBe(0);
    expect(commands).toContain("npm run build --workspace=web/admin");
    expect(commands.indexOf("admin/assets/")).toBeLessThan(commands.indexOf("admin/index.html --cache-control"));
    expect(commands).toContain("public, max-age=31536000, immutable");
    expect(commands).toContain("no-cache, max-age=0, must-revalidate");
    expect(commands).not.toContain("cloudfront create-invalidation");
  });

  it("repairs CloudFront once when index.html did not already have safe cache metadata", () => {
    const fixture = makeFixture("None");

    const result = fixture.run();
    const commands = readFileSync(fixture.logFile, "utf8");

    expect(result.status).toBe(0);
    expect(commands).toContain("cloudfront list-distributions");
    expect(commands).toContain("cloudfront create-invalidation --distribution-id EDIST123");
    expect(commands).toContain("--paths /admin/index.html");
  });

  it("rejects unsupported arguments before contacting AWS", () => {
    const fixture = makeFixture("None");

    const result = fixture.run("--wrong");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: npm run deploy:admin -- [--invalidate]");
  });
});
