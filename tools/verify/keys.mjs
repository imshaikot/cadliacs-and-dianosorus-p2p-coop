/** CDP key specs for the emulator's default keymap (see emulator/input.ts). */
export const KEYS = {
  COIN: { code: 'Digit5', key: '5', vk: 53 },
  START: { code: 'Digit1', key: '1', vk: 49 },
  UP: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  DOWN: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  LEFT: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  RIGHT: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  B1: { code: 'KeyU', key: 'u', vk: 85 },
  B2: { code: 'KeyI', key: 'i', vk: 73 },
  B3: { code: 'KeyO', key: 'o', vk: 79 },
  // Z and X are the second binding on the bottom row, kept because two-button
  // games put hands there and the checks have always pressed them.
  B4: { code: 'KeyZ', key: 'z', vk: 90 },
  B5: { code: 'KeyX', key: 'x', vk: 88 },
  B6: { code: 'KeyC', key: 'c', vk: 67 },
};

/** Mirrors BUTTON in packages/client/src/emulator/input.ts. */
export const BUTTON = {
  B4: 0,
  B1: 1,
  COIN: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  B5: 8,
  B2: 9,
  B3: 10,
  B6: 11,
};
export const bit = (name) => 1 << BUTTON[name];
