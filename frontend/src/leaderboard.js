/**
 * Calculate total equity for a given player:
 * Total Equity = Cash + Total Market Value of Owned Properties - Total Mortgage Balances
 */
export function calculatePlayerEquity(player, gameProps = [], catalog = []) {
  if (!player) return 0;
  const cash = Number(player.cash || 0);
  const playerProps = Array.isArray(gameProps)
    ? gameProps.filter((gp) => gp.owner_user_id === player.user_id && !gp.is_sold_to_buyer)
    : [];

  const propertyEquity = playerProps.reduce((sum, gp) => {
    const prop = Array.isArray(catalog) ? catalog.find((cp) => cp.slug === gp.property_slug) : null;
    const purchasePrice = gp.purchase_price || prop?.cost || 0;
    const marketValue = gp.market_value || purchasePrice;
    const mortgageBalance = Math.max(0, gp.mortgage_balance || 0);
    return sum + (marketValue - mortgageBalance);
  }, 0);

  return cash + propertyEquity;
}

/**
 * Return players ranked by total equity descending.
 */
export function getLeaderboardData(players = [], gameProps = [], catalog = []) {
  if (!Array.isArray(players) || players.length === 0) return [];

  const ranked = players.map((p) => {
    const equity = calculatePlayerEquity(p, gameProps, catalog);
    return {
      userId: p.user_id,
      displayName: p.display_name || 'Player',
      seatNumber: p.seat_number,
      cash: Number(p.cash || 0),
      equity
    };
  });

  // Sort descending by equity, tie-break by cash descending, then seat number ascending
  ranked.sort((a, b) => b.equity - a.equity || b.cash - a.cash || a.seatNumber - b.seatNumber);

  return ranked.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));
}
