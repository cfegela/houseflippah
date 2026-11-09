/**
 * Calculates any pending automated sales proceeds for a player that occurred during the previous
 * round transition and have not yet been acknowledged via the turn-start sales alert modal.
 */
export function getPendingSalesProceeds(userId, currentRound, lastAcknowledgedRound, propertySales = []) {
  if (!userId || !currentRound || currentRound < 2) return 0;
  if (lastAcknowledgedRound >= currentRound) return 0;

  const previousRound = currentRound - 1;
  const pendingSales = (propertySales || []).filter(
    (s) => s.buyer_type === 'automated' &&
           s.round_number === previousRound &&
           s.seller_user_id === userId
  );

  return pendingSales.reduce((sum, s) => sum + (Number(s.net_proceeds) || 0), 0);
}

/**
 * Returns the effective cash balance to display in the user's HUD wallet and financial report,
 * withholding unacknowledged sales proceeds until the player's turn starts and the sales modal is shown.
 */
export function getDisplayCash(player, currentRound, lastAcknowledgedRound, propertySales = []) {
  if (!player) return 0;
  const actualCash = Number(player.cash) || 0;
  const pending = getPendingSalesProceeds(player.user_id, currentRound, lastAcknowledgedRound, propertySales);
  return Math.max(0, actualCash - pending);
}
