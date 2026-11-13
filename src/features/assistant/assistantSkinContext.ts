import { createContext, useContext } from 'react';
import { pixelRobot } from './art/pixelRobot';
import type { AssistantSkin } from './assistantSkin';

// A single injection point for the sidebar, conversation and settings preview.
export const AssistantSkinContext = createContext<AssistantSkin>(pixelRobot);
export const useAssistantSkin = () => useContext(AssistantSkinContext);
