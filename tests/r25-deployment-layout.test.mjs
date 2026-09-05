import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path) { return readFileSync(new URL(`../${path}`, import.meta.url).pathname, "utf8"); }

test("canonical VPS installer uses immutable releases and never re-runs the full historical suite", () => {
  const install = source("deploy/install-vps.sh");
  const env = source("deploy/flerdvision.env.example");
  const unit = source("deploy/flerdvision-daemon.service");
  assert.match(install, /\/opt\/flerdvision\/releases/);
  assert.match(install, /CURRENT_LINK="\$PREFIX\/current"/);
  assert.match(install, /npm run build/);
  assert.doesNotMatch(install, /npm test|test:w8|test:w7/);
  assert.match(install, /secrets\.env/);
  assert.match(install, /posting daemon remains disabled/);
  assert.match(env, /FLERDVISION_WORKSPACE_ROLE=production/);
  assert.match(env, /FLERDVISION_DAEMON_MODE=canary/);
  assert.match(unit, /WorkingDirectory=\/opt\/flerdvision\/current/);
  assert.match(unit, /EnvironmentFile=\/etc\/flerdvision\/secrets\.env/);
  assert.match(unit, /EnvironmentFile=\/etc\/flerdvision\/release\.env/);
});

test("legacy ops installer contains no second implementation", () => {
  const legacy = source("ops/install-vps.sh");
  assert.match(legacy, /forwarding to deploy\/install-vps\.sh/);
  assert.match(legacy, /exec .*deploy\/install-vps\.sh/);
  assert.doesNotMatch(legacy, /npm run build|apt-get|systemctl|workspace -- init/);
});

test("remote browser backend is loopback-only and cannot expose raw VNC or noVNC publicly", () => {
  const backend = source("deploy/novnc-loopback.sh");
  const installer = source("deploy/install-vps.sh");
  assert.match(backend, /-localhost/);
  assert.match(backend, /127\.0\.0\.1:\$NOVNC_PORT/);
  assert.match(backend, /127\.0\.0\.1:\$VNC_PORT/);
  assert.doesNotMatch(backend, /0\.0\.0\.0/);
  assert.doesNotMatch(installer, /ufw allow 6080|ufw allow 5900/);
});

test("update and rollback switch code only and never rewrite persistent secrets or runtime state", () => {
  for (const path of ["deploy/update-release.sh", "deploy/rollback-release.sh"]) {
    const script = source(path);
    assert.match(script, /CURRENT_LINK/);
    assert.match(script, /mv -Tf/);
    assert.doesNotMatch(script, /rm -rf \/var\/lib\/flerdvision|cp .*secrets\.env|cp .*profiles/);
  }
});
