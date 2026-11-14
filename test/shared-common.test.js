const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveExistingSharedAppServer } = require("../scripts/shared-common");

test("shared app-server refuses an unmanaged listener", () => {
  assert.throws(() => {
    resolveExistingSharedAppServer({
      pidFromFile: 1234,
      pidAlive: false,
      ready: true,
    });
  }, /not managed by Cyberboss/);
});
