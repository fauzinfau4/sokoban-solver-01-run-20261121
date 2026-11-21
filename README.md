[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/fauzinfau4/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/fauzinfau4/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
# Sokoban solver — push-optimal per room

One program (`main.ts`, Node 22, no dependencies) that answers every instance of a set.

## The idea

The generator builds each level as a hallway with independent rooms off it, and a box
pushed out of a room can never come back, so a level's push-optimum P\* is the sum of its
rooms' optima. The solver therefore:

1. **Splits** the level into rooms: flood-fill the floor with the hallway row (the row the
   player starts on) blocked; every component holding boxes is a room.
2. **Solves each room push-optimally** with A\* over pushes, treating the other rooms'
   boxes as walls (on their goals once their room is done, where they started otherwise),
   and stitches the rooms together with hallway walks.
3. **Falls back** to plain breadth-first search over pushes for a room A\* gives up on,
   and to a whole-level search when a level is not a set of rooms.

## The room search

A state is the boxes' squares plus the player's reachable region, named by its lowest
square — positions the player can walk between for free are one state. The cost is pushes
made; the heuristic is the minimum-matching sum of walking distances from boxes to goals,
which is admissible because one push moves one box one square and can shrink that sum by
at most one, so the first solved state A\* pops is push-optimal. Two deadlocks are pruned:

- a box on a **dead square**: no pull path from any goal reaches it (reverse-pull search
  from the goals, ignoring the other boxes);
- a box in a **frozen 2×2 block** of walls and boxes that holds a box off its goal.

A solved state only counts when the player can still walk out to the hallway, so the next
room stays reachable. Search is budgeted by states expanded, never by the wall clock, and
nothing is random: two executions write the same bytes.

## Practice set

All five practice instances solve in exactly P\* pushes (13, 16, 29, 47, 60), i.e. 1,000
points each, in under a second for the whole set on this machine.

## License

MIT. See `LICENSE`.

Optional: earn referral rewards, a second way to make money: https://make.fun/r/7tgjyx9m
