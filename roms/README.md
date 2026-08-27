# Game files

Put your own legally-obtained CPS-1 / CPS-2 romsets here, then name one in
`.env` as `VITE_ROM_FILE` so the dev server hands it straight to the emulator:

```
VITE_ROM_FILE=yourgame.zip
```

The driver is chosen from the filename, so `sf2.zip` boots `sf2`. Without that
variable the app shows its file picker instead, which is what a production build
always does.

This directory is gitignored (everything except this file). Nothing in here is
ever committed, and this project will never download a game file for you.
