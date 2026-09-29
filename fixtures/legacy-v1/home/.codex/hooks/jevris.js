export const id = 'jevris';

export async function observe() {
  return { applied: false, toolPermission: false, authorizesEffect: false, providerCalls: 0 };
}
