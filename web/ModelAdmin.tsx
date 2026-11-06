import type { Model, Settings, ModelEditorProps, ImageModelProps } from "./modelAdminTypes";
import {
  ModelAdminTemplate,
  ModelEditorTemplate,
  ImageModelTemplate,
} from "./templates/ModelAdmin.template";
import { uiText, type MessageKey } from "../src/i18n";
import { useUiLanguage } from "../src/i18n/react";
import { useEffect, useState, type FormEvent } from "react";
import { api, requestId } from "./api";

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : uiText()("networkProxySettings.saveDidNotCompletePleaseRetry");
const editable = ({ hasApiKey: _, ...model }: Model) => model;

export function ModelAdmin() {
  const language = useUiLanguage();

  const [settings, setSettings] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState<MessageKey | "">("");
  const [editor, setEditor] = useState<Model | "new" | null>(null),
    [removal, setRemoval] = useState<Model | null>(null);
  async function refresh() {
    setError("");
    try {
      setSettings(await api<Settings>("/admin/models"));
      setEditor(null);
      setRemoval(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function change(input: Record<string, unknown>) {
    if (!settings) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setSettings(
        await api<Settings>("/admin/models", "POST", {
          ...input,
          revision: settings.revision,
        }),
      );
      setEditor(null);
      setRemoval(null);
      setNotice(
        "web.savedNewRequestsWillUseThisConfiguration",
      );
      window.dispatchEvent(new Event("cardbush:models-changed"));
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModelAdminTemplate
      settings={settings}
      busy={busy}
      error={error}
      notice={notice ? uiText(language)(notice) : ""}
      editor={editor}
      removal={removal}
      refresh={refresh}
      change={change}
      setError={setError}
      setEditor={setEditor}
      setRemoval={setRemoval}
      toggleModel={(model) => {
        void change({
          action: "save",
          model: { ...editable(model), enabled: !model.enabled },
        });
      }}
      editorForm={
        editor && (
          <ModelEditor
            key={typeof editor === "string" ? editor : editor.id}
            value={editor === "new" ? null : editor}
            isDefault={
              editor !== "new" && editor.id === settings?.defaultModelId
            }
            busy={busy}
            error={error}
            close={() => {
              if (!busy) {
                setEditor(null);
                setError("");
              }
            }}
            save={(model) => change({ action: "save", model })}
          />
        )
      }
      imageForm={
        settings && (
          <ImageModelForm
            key={`${settings.revision}`}
            value={settings.imageModel}
            busy={busy}
            save={change}
          />
        )
      }
    />
  );
}

function ModelEditor({
  value,
  isDefault,
  busy,
  error,
  close,
  save,
}: ModelEditorProps) {
  const [id] = useState(
    value?.id ?? `model_${requestId().replaceAll("-", "").slice(0, 16)}`,
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save({
      id,
      name: form.get("name"),
      model: form.get("model"),
      baseURL: form.get("baseURL"),
      apiKey: form.get("apiKey"),
      apiProtocol: form.get("apiProtocol"),
      maxContextTokens: Number(form.get("maxContextTokens")),
      maxOutputTokens: Number(form.get("maxOutputTokens")),
      reasoningEffort:
        form.get("reasoningEffort") === "default"
          ? null
          : form.get("reasoningEffort"),
      enabled: isDefault || form.get("enabled") === "on",
    });
  }
  return (
    <ModelEditorTemplate
      value={value}
      isDefault={isDefault}
      busy={busy}
      error={error}
      close={close}
      submit={submit}
    />
  );
}

function ImageModelForm({
  value,
  busy,
  save,
}: ImageModelProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save({
      action: "image",
      model: form.get("model"),
      apiKey: form.get("apiKey"),
    });
  }
  return <ImageModelTemplate value={value} busy={busy} submit={submit} />;
}
