if (process.stdin) {
  process.stdin.resume();

  const keepAlive = setInterval(() => {}, 1_000);
  let released = false;

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearInterval(keepAlive);
  };

  process.stdin.once("data", release);
}
