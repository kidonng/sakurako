import { Clock, Context, Effect, Layer, Ref } from "effect";

export class StatsCooldown extends Context.Service<
  StatsCooldown,
  {
    readonly checkAndSet: (
      groupId: number,
      cooldownMs?: number,
    ) => Effect.Effect<boolean>;
  }
>()("sakurako/StatsCooldown") {
  static readonly layer = Layer.effect(
    StatsCooldown,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyMap<number, number>>(new Map());
      const checkAndSet = Effect.fnUntraced(function* (
        groupId: number,
        cooldownMs = 5000,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Ref.modify(ref, (map) => {
          const last = map.get(groupId) ?? 0;
          if (now - last < cooldownMs) {
            return [false, map] as const;
          }
          const next = new Map(map);
          next.set(groupId, now);
          return [true, next] as const;
        });
      });

      return StatsCooldown.of({ checkAndSet });
    }),
  );
}
