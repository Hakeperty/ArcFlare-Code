const E = String.fromCharCode(27);
console.log("isTTY   =", process.stdout.isTTY);
console.log("TERM    =", process.env.TERM || "(unset)");
console.log("NO_COLOR=", process.env.NO_COLOR === undefined ? "(unset)" : process.env.NO_COLOR);
console.log("colorDepth =",
  process.stdout.getColorDepth ? process.stdout.getColorDepth() : "n/a");
process.stdout.write(
  E + "[38;5;214mAMBER-256" + E + "[0m | " +
  E + "[2mDIM" + E + "[0m | " +
  E + "[31mRED-basic" + E + "[0m | " +
  E + "[1mBOLD" + E + "[0m\n");
console.log("ui.useColor =", require("../lib/ui").useColor);
