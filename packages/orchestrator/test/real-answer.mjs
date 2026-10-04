// What a validated Jev answer looks like to a consumer: the engine always gives a Choice or a Score its
// `confidence` (and a Choice its probabilities), and a Noul its probability. A test stub that scripts
// `{ choice: 'x' }` or `{ score: 2 }` stands for a confident answer; a test of the confidence floor says
// its own `confidence`.
export function asEngineAnswer(answer) {
  if (answer === null || typeof answer !== 'object') return answer;
  if (typeof answer.choice === 'string') return { confidence: 1, probabilities: { [answer.choice]: 1 }, ...answer };
  if (typeof answer.score === 'number') return { confidence: 1, ...answer };
  return answer;
}
