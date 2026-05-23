// The free-text intent classifier (classifyTask / classifyGoal) has been
// removed (RLM-first routing; "keyword classification is totally wrong").
// runtime/task_route.ts intentionally exports no classifier, so there is
// nothing to unit-test here.
//
// Routing-regression coverage now lives in generate_select_dispatch.test.ts,
// which asserts the RLM-first gate matrix: the env flag alone never
// authorizes interception; only an injected scored `shouldHandle` predicate
// does, and a missing/false predicate falls through to the brain.

export {};
