const base = require('./ecosystem.config.cjs');

// Opt-in per-process workaround: choose the first lookup result with IPv4 first,
// rather than racing address families. Existing .env and NODE_OPTIONS stay intact.
module.exports = {
  ...base,
  apps: base.apps.map(app => ({
    ...app,
    node_args: [
      ...app.node_args,
      '--no-network-family-autoselection',
      '--dns-result-order=ipv4first',
    ],
  })),
};
