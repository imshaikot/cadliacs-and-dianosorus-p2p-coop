# Game files

Put your own legally-obtained romsets here — CPS-1 / CPS-2 or Neo Geo — then
name one in `.env` as `VITE_ROM_FILE` so the dev server hands it straight to the
emulator:

```
VITE_ROM_FILE=yourgame.zip
```

The driver is chosen from the filename, so `sf2.zip` boots `sf2`. The name also
settles which emulator comes up: this is the one path with no dropdown on it, so
`sf2.zip` gets the CPS core and `mslug.zip` gets Neo Geo.

Neo Geo drivers boot through the BIOS romset, which is a second file:

```
VITE_ROM_FILE=mslug.zip
VITE_ROM_BIOS_FILE=neogeo.zip
```

Without `VITE_ROM_FILE` the app shows its file picker instead, which is what a
production build always does.

This directory is gitignored (everything except this file). Nothing in here is
ever committed, and this project will never download a game file for you.
