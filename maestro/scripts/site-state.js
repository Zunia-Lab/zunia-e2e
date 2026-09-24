// What the site shows, read from scripts/mobile-connect.mjs: its copy of the
// verification code and the host the relay saw. The sheet draws the code as
// "123 456" and reads it out digit by digit, so match either form.
const state = json(http.get(STATE_URL).body);
const digits = String(state.code);
output.code = digits.slice(0, 3) + " " + digits.slice(3) + "|" + digits.split("").join(" ");
output.host = state.host;
