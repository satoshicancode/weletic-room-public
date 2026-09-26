"use client";
import { createContext, useContext } from "react";
// Presentation only. Server mutation and runtime admission remain authoritative.
export const CoreLaunchContext = createContext(false);
export const useCoreLaunch = () => useContext(CoreLaunchContext);
