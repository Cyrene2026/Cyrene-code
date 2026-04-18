const { formatWithOptions } = require("node:util");

const redirectToStderr = methodName => {
  const original = console[methodName];
  if (typeof original !== "function") {
    return;
  }

  console[methodName] = (...args) => {
    const line = formatWithOptions({}, ...args);
    process.stderr.write(`${line}\n`);
  };
};

redirectToStderr("log");
redirectToStderr("info");
redirectToStderr("debug");
