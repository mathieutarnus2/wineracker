/* Les formules. Les montants sont TTC, en centimes. Les « lookup keys » relient chaque formule à son prix Stripe. */
module.exports = {
  GRATUIT: 50,
  PLANS: {
    cave100: { nom: "Cave 100", limite: 100, centimes: 999, cle: "wineracker_cave100_an" },
    cave200: { nom: "Cave 200", limite: 200, centimes: 1499, cle: "wineracker_cave200_an" },
    illimite: { nom: "Grande cave", limite: 1e9, centimes: 1999, cle: "wineracker_illimite_an" },
  },
};
