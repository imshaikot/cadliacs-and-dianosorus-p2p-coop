/**
 * The bits of the app the checks all have to drive, in one place.
 *
 * `cdp.mjs` stays app-agnostic — it knows about tabs, mouse events and
 * screenshots. Everything here knows about *this* page: that HOST and JOIN both
 * open an identity dialog, that the dialog will not submit without a name, and
 * which selectors carry which. When the landing flow changes again, it changes
 * here rather than in six checks.
 */

/** Waits for the identity dialog, fills it in, and confirms. */
async function completeIdentity(tab, { name, avatar }) {
  await tab.waitFor('document.getElementById("identity-modal").open === true', 5000, 'identity dialog');
  await tab.typeInto('#input-name', name);
  if (avatar) {
    // Click the label, not the radio: the radio is visually hidden so that the
    // tile can be the thing people (and trusted mouse events) actually hit.
    await tab.clickSelector(`.avatar-pick[data-avatar="${avatar}"]`);
  }
  await tab.waitFor(
    'document.getElementById("btn-identity-go").disabled === false',
    5000,
    'identity dialog accepts the name',
  );
  await tab.clickSelector('#btn-identity-go');
}

/** HOST A GAME, all the way through to a room. */
export async function hostGame(tab, { name = 'Ada', avatar = 'joystick' } = {}) {
  await tab.clickSelector('#btn-host');
  await completeIdentity(tab, { name, avatar });
}

/** Type a room code and JOIN, all the way through to a room. */
export async function joinGame(tab, code, { name = 'Bo', avatar = 'coin' } = {}) {
  await tab.typeInto('#input-code', code);
  await tab.clickSelector('#btn-join');
  await completeIdentity(tab, { name, avatar });
}

/**
 * Fill the dialog but stop short of confirming — for checks that care about the
 * dialog's own rules rather than about getting into a room.
 */
export async function openIdentity(tab, role, code) {
  if (role === 'guest') {
    await tab.typeInto('#input-code', code);
    await tab.clickSelector('#btn-join');
  } else {
    await tab.clickSelector('#btn-host');
  }
  await tab.waitFor('document.getElementById("identity-modal").open === true', 5000, 'identity dialog');
}

/** Everyone joins muted, so any check that wants voice has to ask for it. */
export async function toggleMic(tab) {
  await tab.clickSelector('#btn-mic');
}
