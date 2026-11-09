/**
 * Return delinquent properties owned by the user that require payment this round to stave off foreclosure.
 */
export function getDelinquentProperties(userId, gameProps = [], currentRound = 1) {
  if (!userId || !Array.isArray(gameProps)) return [];

  return gameProps.filter((gp) => {
    if (gp.owner_user_id !== userId) return false;
    const missed = Number(gp.missed_payments || 0);
    const lastPaid = Number(gp.last_paid_round || 0);
    return missed >= 1 && lastPaid < currentRound;
  });
}
