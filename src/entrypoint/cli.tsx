import React from "react";
import { render } from "ink";
import { ChatCliApp } from "../frontend/components/ChatCliApp";
import { createHttpQueryTransport } from "../infra/http/createHttpQueryTransport";

const transport = createHttpQueryTransport();

render(<ChatCliApp transport={transport} />);
