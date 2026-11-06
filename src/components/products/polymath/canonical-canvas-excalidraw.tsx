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
import { useRef, type RefObject } from "react";
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
  // Dirty tracking: Excalidraw fires onChange when it applies initialData
  // and again while fonts and bindings settle — and the settled elements can
  // differ from the converter output — so no onChange means "edited" by
  // itself. Until the user's first pointer/keyboard gesture on the canvas,
  // every onChange just re-arms the baseline; after that gesture, a change
  // whose elements differ from the settled baseline is a real edit. The
  // parent remounts this component per version and per save, which resets
  // both refs.
  const armedRef = useRef(false);
  const baselineRef = useRef<string | null>(null);
  const mountedElements = (
    convertSkeletons ? convertToExcalidrawElements(initial.elements as ExcalidrawElementSkeleton[]) : initial.elements
  ) as never;

  return (
    <div
      className="panel relative h-[600px] min-h-96 overflow-hidden rounded-xl"
      onPointerDownCapture={() => {
        armedRef.current = true;
      }}
      onKeyDownCapture={() => {
        armedRef.current = true;
      }}
    >
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
            elements: mountedElements,
            ...(initial.appState ? { appState: initial.appState as never } : {}),
            ...(initial.files ? { files: initial.files as never } : {}),
            scrollToContent: true,
          }}
          onChange={(elements) => {
            const key = JSON.stringify(elements);
            if (!armedRef.current) {
              baselineRef.current = key;
              return;
            }
            if (key !== baselineRef.current) onSceneChange();
          }}
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
