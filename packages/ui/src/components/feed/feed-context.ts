import { createContext, useContext } from 'react';

/** Which agent a feed belongs to (for URLs like tool-result images). */
export const FeedContext = createContext<{ nodeKey: string; agentId: string } | null>(null);
export const useFeedContext = () => useContext(FeedContext);
