// Promotes an existing local operator to host and marks it as this hub's
// single main host. This intentionally preserves the account password and is
// only a local CLI operation; main-host authority is never HTTP-settable.
//
// Usage:
//   node server/scripts/set-main-host.js <username>

// Set OPERATORS_CONFIG_PATH when operating on an installed desktop host.

import { operators, setMainHost, updateOperatorAccount } from "../src/authStore.js";

const [, , username] = process.argv;

if (!username) {
  console.error("Usage: node server/scripts/set-main-host.js <username>");
  process.exit(1);
}

try {
  const current = operators.get(username);
  if (!current) throw new Error(`operator not found: ${username}`);

  const existingMainHost = [...operators.values()].find(
    operator => operator.isMainHost === true && operator.username !== username,
  );
  if (existingMainHost) throw new Error(`main host already exists: ${existingMainHost.username}`);

  if (current.role !== "host") updateOperatorAccount(username, { role: "host" });
  if (!operators.get(username)?.isMainHost) setMainHost(username, true);

  console.log(`"${username}" is now the main host.`);
  console.log("role: host");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
