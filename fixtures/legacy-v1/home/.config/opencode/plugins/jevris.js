const recorded = [];
const CAP = 32;

function record(input) {
  recorded.push(input);
  if (recorded.length > CAP) recorded.shift();
}

function eventType(input) {
  if (input === null || typeof input !== 'object') return undefined;
  const event = input.event;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const type = event.type;
  return typeof type === 'string' ? type : undefined;
}

async function JevrisPlugin() {
  return {
    event: async (input) => {
      const type = eventType(input);
      record(type === undefined ? input : { type });
    },
    'tool.execute.before': async (input) => {
      record(input);
    },
    'tool.execute.after': async (input) => {
      record(input);
    },
    'chat.message': async (input) => {
      record(input);
    },
    'experimental.session.compacting': async (input) => {
      record(input);
    },
  };
}

module.exports = JevrisPlugin;
module.exports.JevrisPlugin = JevrisPlugin;
