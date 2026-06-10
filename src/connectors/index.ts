// Importing this module registers all connector tools.
// Connectors are optional integrations — each one degrades to an honest
// "not configured / not reachable" message rather than failing the agent.
import './claude-code.ts';
import './open-design.ts';
