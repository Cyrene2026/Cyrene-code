import React from "react";
import type { QueryTransport } from "../../core/query/transport";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";

type ChatCliAppProps = {
  transport: QueryTransport;
};

export const ChatCliApp = ({ transport }: ChatCliAppProps) => {
  const { items, input, status, setInput, submit } = useChatApp({ transport });

  return (
    <ChatScreen
      items={items}
      input={input}
      status={status}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
