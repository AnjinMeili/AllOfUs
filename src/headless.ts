import { createInterface } from 'node:readline';
import { createAgent } from './agent.js';
import { defaultTools } from './tools.js';
import { getKey } from './get-key.js';

async function main() {
  const agent = createAgent({
    apiKey: await getKey('openrouter'),
    model: 'openrouter/auto',
    instructions: 'You are a helpful assistant with access to tools.',
    tools: defaultTools,
  });

  agent.on('thinking:start', () => console.log('\nThinking...'));
  agent.on('tool:call', (name, args) => console.log(`Tool call ${name}:`, args));
  agent.on('stream:delta', (delta) => process.stdout.write(delta));
  agent.on('stream:end', () => console.log('\n'));
  agent.on('error', (err) => console.error('Error:', err.message));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('Agent ready. Type your message (Ctrl+C to exit).\n');

  const prompt = () => {
    rl.question('You: ', async (input: string) => {
      if (!input.trim()) {
        prompt();
        return;
      }

      try {
        await agent.send(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Request failed:', message);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
