"use client";

import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  convertToExcalidrawElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { RefObject } from "react";
import type { ExcalidrawScenePayload } from "@/domains/diagrams/types";

/*
 * The Excalidraw mount for the canonical canvas editor — everything that
 * pulls @excalidraw/excalidraw into the bundle lives here, behind the
 * parent's next/dynamic ssr:false split (locked decision 7).
 *
 * Two element shapes arrive: full serialized elements from a saved
 * checkpoint (mounted as-is) and converter skeletons from a Mermaid
 * conversion (converted first, the same call the preview editor's templates
 * use).
 */
export default function CanonicalCanvasExcalidraw({
  initial,
  convertSkeletons,
  theme,
  name,
  onSceneChange,
  sceneApiRef,
}: {
  initial: ExcalidrawScenePayload;
  convertSkeletons: boolean;
  theme: "dark" | "light";
  name: string;
  onSceneChange: () => void;
  sceneApiRef: RefObject<{ scene: () => ExcalidrawScenePayload } | null>;
}) {
  return (
    <div className="panel relative h-[600px] min-h-96 overflow-hidden rounded-xl">
      <div className="h-full min-h-0">
        <Excalidraw
          excalidrawAPI={(instance: ExcalidrawImperativeAPI) => {
            sceneApiRef.current = {
              scene: () => {
                const serialized = JSON.parse(
                  serializeAsJSON(instance.getSceneElements(), instance.getAppState(), instance.getFiles(), "database"),
                ) as ExcalidrawScenePayload;
                return { elements: serialized.elements, appState: serialized.appState, files: serialized.files };
              },
            };
          }}
          theme={theme}
          name={name}
          initialData={{
            elements: convertSkeletons
              ? convertToExcalidrawElements(initial.elements as ExcalidrawElementSkeleton[])
              : (initial.elements as never),
            ...(initial.appState ? { appState: initial.appState as never } : {}),
            ...(initial.files ? { files: initial.files as never } : {}),
            scrollToContent: true,
          }}
          onChange={() => onSceneChange()}
          isCollaborating={false}
          aiEnabled={false}
          validateEmbeddable={false}
          handleKeyboardGlobally={false}
          UIOptions={{
            canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false },
            tools: { image: false },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>Draw, connect, then save a checkpoint.</WelcomeScreen.Center.Heading>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
      </div>
    </div>
  );
}
