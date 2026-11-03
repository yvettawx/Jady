import { createContext, useContext } from "react";
import type { WorkspaceApi } from "./api";

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);
export const useWorkspace = () => useContext(WorkspaceContext);
