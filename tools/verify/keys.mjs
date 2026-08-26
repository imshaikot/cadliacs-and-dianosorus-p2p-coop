/** CDP key specs for the emulator's default keymap (see emulator/input.ts). */
export const KEYS = {
  COIN: { code: 'Digit5', key: '5', vk: 53 },
  START: { code: 'Digit1', key: '1', vk: 49 },
  UP: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  DOWN: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  LEFT: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  RIGHT: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  ATTACK: { code: 'KeyZ', key: 'z', vk: 90 },
  JUMP: { code: 'KeyX', key: 'x', vk: 88 },
};

/** Mirrors BUTTON in packages/client/src/emulator/input.ts. */
export const BUTTON = { ATTACK: 0, COIN: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, JUMP: 8 };
export const bit = (name) => 1 << BUTTON[name];
