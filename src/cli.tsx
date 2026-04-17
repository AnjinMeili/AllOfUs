import React, { useCallback, useEffect, useState } from 'react';
import type { StreamableOutputItem } from '@openrouter/sdk/lib/stream-transformers.js';
import { Box, Text, render, useApp, useInput } from 'ink';
import { createAgent, type Agent, type Message } from './agent.js';
import { defaultTools } from './tools.js';
import { getKey } from './get-key.js';

function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? 'cyan' : 'green'}>
        {isUser ? 'You' : 'Assistant'}
      </Text>
      <Text wrap="wrap">{message.content}</Text>
    </Box>
  );
}

function ItemRenderer({ item }: { item: StreamableOutputItem }) {
  switch (item.type) {
    case 'message': {
      const textContent = item.content?.find((c: { type: string }) => c.type === 'output_text');
      const text = textContent && 'text' in textContent ? String(textContent.text) : '';
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Assistant</Text>
          <Text wrap="wrap">{text}</Text>
          {item.status !== 'completed' ? <Text color="gray">...</Text> : null}
        </Box>
      );
    }
    case 'function_call': {
      return (
        <Text color="yellow">
          {item.status === 'completed' ? 'Done' : 'Running'} tool: {item.name}
        </Text>
      );
    }
    case 'reasoning': {
      const reasoningText = item.content?.find((c: { type: string }) => c.type === 'reasoning_text');
      const text = reasoningText && 'text' in reasoningText ? String(reasoningText.text) : '';
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="magenta">Thinking</Text>
          <Text wrap="wrap" color="gray">
            {text}
          </Text>
        </Box>
      );
    }
    default:
      return null;
  }
}

function InputField({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  useInput((input: string, key) => {
    if (disabled) return;
    if (key.return) onSubmit();
    else if (key.backspace || key.delete) onChange(value.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) onChange(value + input);
  });

  return (
    <Box>
      <Text color="yellow">&gt; </Text>
      <Text>{value}</Text>
      <Text color="gray">{disabled ? ' ...' : ' _'}</Text>
    </Box>
  );
}

function App({ agent }: { agent: Agent }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [items, setItems] = useState<Map<string, StreamableOutputItem>>(new Map());

  useInput((_, key) => {
    if (key.escape) {
      exit();
    }
  });

  useEffect(() => {
    const onThinkingStart = () => {
      setIsLoading(true);
      setItems(new Map());
    };

    const onItemUpdate = (item: StreamableOutputItem) => {
      setItems((prev) => {
        const id = item.id ?? `${item.type}-latest`;
        const next = new Map(prev);
        next.set(id, item);
        return next;
      });
    };

    const onMessageAssistant = () => {
      setMessages(agent.getMessages());
      setItems(new Map());
      setIsLoading(false);
    };

    const onError = () => {
      setIsLoading(false);
    };

    agent.on('thinking:start', onThinkingStart);
    agent.on('item:update', onItemUpdate);
    agent.on('message:assistant', onMessageAssistant);
    agent.on('error', onError);

    return () => {
      agent.off('thinking:start', onThinkingStart);
      agent.off('item:update', onItemUpdate);
      agent.off('message:assistant', onMessageAssistant);
      agent.off('error', onError);
    };
  }, [agent]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading) {
      return;
    }

    const text = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);

    await agent.send(text);
  }, [input, isLoading, agent]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">OpenRouter Agent</Text>
        <Text color="gray"> (Esc to exit)</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, index) => (
          <ChatMessage key={`${msg.role}-${index}`} message={msg} />
        ))}

        {Array.from(items.values()).map((item, index) => (
          <ItemRenderer key={item.id ?? `${item.type}-${index}`} item={item} />
        ))}
      </Box>

      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <InputField value={input} onChange={setInput} onSubmit={sendMessage} disabled={isLoading} />
      </Box>
    </Box>
  );
}

async function main(): Promise<void> {
  const agent = createAgent({
    apiKey: await getKey('openrouter'),
    model: 'openrouter/auto',
    instructions: 'You are a helpful assistant. Be concise.',
    tools: defaultTools,
  });
  render(<App agent={agent} />);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
