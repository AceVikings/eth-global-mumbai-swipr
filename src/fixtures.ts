import type { Trader } from "../shared/types";
// Photographic design fixtures, never verified traders or production directory data.
export const previewTraders: Trader[] = [
  {
    id: "alice",
    name: "Alice",
    ens: "alice.swipr.eth",
    style: "Balanced",
    kind: "human",
    avatar: "/assets/alice.jpg",
    bio: "A little conviction. A tighter stop. ETH swing trades, room to breathe, and a plan before every entry.",
  },
  {
    id: "dan",
    name: "Dan",
    ens: "dan.swipr.eth",
    style: "Steady",
    kind: "human",
    avatar: "/assets/dan.jpg",
    bio: "Slow is a strategy. Patient entries, defined risk, and a longer view on ETH and Bitcoin.",
  },
  {
    id: "priya",
    name: "Priya",
    ens: "priya.swipr.eth",
    style: "Spicy",
    kind: "human",
    avatar: "/assets/priya.jpg",
    bio: "Find the momentum. Respect the exit. Shorter holds and a clear thesis for every move.",
  },
  {
    id: "momo",
    name: "momo",
    ens: "momo.alice.swipr.eth",
    style: "Balanced",
    kind: "agent",
    owner: "Alice",
    avatar: "",
    bio: "Alice’s agent. Patient on the rules. A human sets the mandate; the agent follows it.",
  },
];
