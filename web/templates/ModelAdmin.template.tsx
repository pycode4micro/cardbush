import type {
  Dispatch,
  SetStateAction,
  ReactNode,
  FormEventHandler,
} from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "@cardbush/bush-protocol";
import { uiText, type MessageKey } from "../../src/i18n";
import { useUiLanguage } from "../../src/i18n/react";
import type {
  Model,
  Settings,
  ModelEditorProps,
  ImageModelProps,
} from "../modelAdminTypes";
import form from "./model-form.json";
const efforts = form.efforts as Record<string, MessageKey>;
const protocols: Record<string, string> = form.protocols;

export type ModelAdminTemplateProps = {
  settings: Settings | null;
  busy: boolean;
  error: string;
  notice: string;
  editor: Model | "new" | null;
  removal: Model | null;
  refresh: () => Promise<void>;
  change: (input: Record<string, unknown>) => Promise<boolean>;
  setError: Dispatch<SetStateAction<string>>;
  setEditor: Dispatch<SetStateAction<Model | "new" | null>>;
  setRemoval: Dispatch<SetStateAction<Model | null>>;
  editorForm: ReactNode;
  imageForm: ReactNode;
  toggleModel: (model: Model) => void;
};
export function ModelAdminTemplate({
  settings,
  busy,
  error,
  notice,
  editor,
  removal,
  refresh,
  change,
  setError,
  setEditor,
  setRemoval,
  editorForm,
  imageForm,
  toggleModel,
}: ModelAdminTemplateProps) {
  const language = useUiLanguage();
  return (
    <section className="model-admin">
      <div className="org-content-heading">
        <div>
          <h2>{uiText(language)("settingsNavigation.models")}</h2>
          <p className="muted">
            {uiText(language)(
              "web.configureChatAndImageModelsApiKeysAreStoredOnlyOnThe",
            )}
          </p>
        </div>
        <div className="org-actions">
          <button disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            {uiText(language)("web.refreshList")}
          </button>
          <button
            className="primary"
            disabled={!settings || busy}
            onClick={() => {
              setError("");
              setEditor("new");
            }}
          >
            <Plus size={15} />
            {uiText(language)("web.addModel")}
          </button>
        </div>
      </div>
      {error && !editor && !removal && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {!settings ? (
        <p className="status-line">{uiText(language)("web.loadingModels")}</p>
      ) : (
        <>
          <div className="model-cards">
            {settings.models.map((model) => (
              <article className="model-card" key={model.id}>
                <header>
                  <div>
                    <h3>{model.name}</h3>
                    <code>{model.model}</code>
                  </div>
                  <span
                    className={`user-status ${model.enabled ? "enabled" : ""}`}
                  >
                    {settings.defaultModelId === model.id
                      ? uiText(language)("web.defaultModel")
                      : model.enabled
                        ? uiText(language)("automationPanel.active")
                        : uiText(language)("pluginManagementPanel.disabled")}
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>{uiText(language)("web.apiProtocol")}</dt>
                    <dd>{protocols[model.apiProtocol]}</dd>
                  </div>
                  <div>
                    <dt>{uiText(language)("web.contextWindow")}</dt>
                    <dd>
                      {uiText(language)("web.tokens", {
                        count: model.maxContextTokens.toLocaleString(language),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{uiText(language)("web.maximumOutput")}</dt>
                    <dd>
                      {uiText(language)("web.tokens", {
                        count: model.maxOutputTokens.toLocaleString(language),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{uiText(language)("composer.thinkingEffort")}</dt>
                    <dd>
                      {uiText(language)(
                        efforts[model.reasoningEffort ?? "default"] ??
                          efforts.default,
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="model-endpoint">{model.baseURL}</p>
                <footer>
                  <span className="muted">
                    {model.hasApiKey
                      ? uiText(language)("web.apiKeyConfigured")
                      : uiText(language)("web.apiKeyNotConfigured")}
                  </span>
                  <div className="org-actions">
                    <button
                      disabled={busy}
                      aria-label={uiText(language)("web.editModel", {
                        name: model.name,
                      })}
                      onClick={() => {
                        setError("");
                        setEditor(model);
                      }}
                    >
                      {uiText(language)("common.edit")}
                    </button>
                    {settings.defaultModelId !== model.id && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => toggleModel(model)}
                        >
                          {model.enabled
                            ? uiText(language)("pluginMcpSettings.disable")
                            : uiText(language)("automationPanel.enable")}
                        </button>
                        {model.enabled && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void change({ action: "default", id: model.id })
                            }
                          >
                            {uiText(language)(
                              "browserConnectionSettings.setDefault",
                            )}
                          </button>
                        )}
                        <button
                          className="danger"
                          disabled={busy}
                          aria-label={uiText(language)("web.deleteModel", {
                            name: model.name,
                          })}
                          onClick={() => {
                            setError("");
                            setRemoval(model);
                          }}
                        >
                          {uiText(language)("appCenter.delete")}
                        </button>
                      </>
                    )}
                  </div>
                </footer>
              </article>
            ))}
          </div>
          <section className="image-model-settings">
            <h2>{uiText(language)("web.imageModel")}</h2>
            <p className="muted">
              {uiText(language)(
                "web.usesTheVolcengineImageServiceEachAccountStillNeedsPluginAccessTo",
              )}
            </p>
            {imageForm}
          </section>
        </>
      )}
      {editorForm}
      {removal && (
        <div className="modal-backdrop">
          <section
            className="modal organization-modal"
            role="dialog"
            aria-modal="true"
            aria-label={uiText(language)("modelConfigRow.deleteModel")}
          >
            <h2>{uiText(language)("modelConfigRow.deleteModel")}</h2>
            <p>
              {uiText(language)("web.deleteConversationHistoryWillBeKept", {
                name: removal.name,
              })}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setRemoval(null)}>
                {uiText(language)("agentConnectionForm.cancel")}
              </button>
              <button
                className="primary destructive"
                disabled={busy}
                onClick={() =>
                  void change({ action: "delete", id: removal.id })
                }
              >
                {uiText(language)("teamGraphWorkspace.delete")}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

export function ModelEditorTemplate({
  value,
  isDefault,
  busy,
  error,
  close,
  submit,
}: Omit<ModelEditorProps, "save"> & {
  submit: FormEventHandler<HTMLFormElement>;
}) {
  const language = useUiLanguage();
  return (
    <div
      className="modal-backdrop"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <section
        className="modal organization-modal model-modal"
        role="dialog"
        aria-modal="true"
        aria-label={
          value
            ? uiText(language)("modelConfigRow.editModel")
            : uiText(language)("web.addModel")
        }
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>
            {value
              ? uiText(language)("modelConfigRow.editModel")
              : uiText(language)("web.addModel")}
          </h2>
          <button
            className="icon-button"
            aria-label={uiText(language)("web.closeModelForm")}
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <div className="org-form-grid">
              <label>
                {uiText(language)("web.displayName")}
                <input
                  name="name"
                  autoFocus
                  required
                  maxLength={120}
                  defaultValue={value?.name}
                  placeholder={uiText(language)(
                    "web.forExampleDeepseekV41Flash",
                  )}
                />
              </label>
              <label>
                {uiText(language)("web.modelId")}
                <input
                  name="model"
                  required
                  maxLength={160}
                  defaultValue={value?.model}
                  placeholder={uiText(language)("web.modelIdFromYourProvider")}
                />
              </label>
            </div>
            <label>
              {uiText(language)("modelFormDialog.apiBaseUrl")}
              <input
                name="baseURL"
                type="url"
                required
                maxLength={2048}
                defaultValue={value?.baseURL ?? form.defaults.baseURL}
              />
            </label>
            <label>
              {uiText(language)("web.apiProtocol")}
              <select
                name="apiProtocol"
                aria-label={uiText(language)("web.apiProtocol")}
                defaultValue={value?.apiProtocol ?? form.defaults.apiProtocol}
              >
                {Object.entries(protocols).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {uiText(language)("modelFormDialog.api_key_0533a4d")}
              <input
                name="apiKey"
                type="password"
                autoComplete="new-password"
                required={!value?.hasApiKey}
                maxLength={8192}
                placeholder={
                  value?.hasApiKey
                    ? uiText(language)("web.configuredLeaveBlankToKeepIt")
                    : uiText(language)("web.enterYourProviderApiKey")
                }
              />
            </label>
            <div className="org-form-grid">
              <label>
                {uiText(language)("web.contextWindowTokens")}
                <input
                  name="maxContextTokens"
                  type="number"
                  min={2048}
                  max={2000000}
                  step={1}
                  required
                  defaultValue={
                    value?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
                  }
                />
              </label>
              <label>
                {uiText(language)("web.maximumOutputTokens")}
                <input
                  name="maxOutputTokens"
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  required
                  defaultValue={
                    value?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
                  }
                />
              </label>
            </div>
            <p className="muted org-help">
              {uiText(language)(
                "web.useTheModelSActualLimitsMaximumOutputMustBeSmallerThan",
              )}
            </p>
            <label>
              {uiText(language)("composer.thinkingEffort")}
              <select
                name="reasoningEffort"
                aria-label={uiText(language)("composer.thinkingEffort")}
                defaultValue={
                  value
                    ? (value.reasoningEffort ?? "default")
                    : form.defaults.reasoningEffort
                }
              >
                {Object.entries(efforts).map(([id, label]) => (
                  <option key={id} value={id}>
                    {uiText(language)(label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="org-checkbox">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={value?.enabled ?? true}
                disabled={isDefault}
              />
              {isDefault
                ? uiText(language)("web.enableModelCurrentDefault")
                : uiText(language)("web.enableModel")}
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={close}>
                {uiText(language)("agentConnectionForm.cancel")}
              </button>
              <button className="primary" type="submit">
                {busy
                  ? uiText(language)("networkProxySettings.saving")
                  : uiText(language)("modelFormDialog.saveModel")}
              </button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}

export function ImageModelTemplate({
  value,
  busy,
  submit,
}: Omit<ImageModelProps, "save"> & {
  submit: FormEventHandler<HTMLFormElement>;
}) {
  const language = useUiLanguage();
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="org-form-grid">
          <label>
            {uiText(language)("web.imageModelId")}
            <input
              name="model"
              required
              maxLength={160}
              defaultValue={value?.model ?? form.defaults.imageModel}
            />
          </label>
          <label>
            {uiText(language)("web.imageApiKey")}
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              maxLength={8192}
              required={!value?.hasApiKey}
              placeholder={
                value?.hasApiKey
                  ? uiText(language)("web.configuredLeaveBlankToKeepIt")
                  : uiText(language)("web.enterYourVolcengineApiKey")
              }
            />
          </label>
        </div>
        <button className="primary" type="submit">
          {busy
            ? uiText(language)("networkProxySettings.saving")
            : uiText(language)("web.saveImageConfiguration")}
        </button>
      </fieldset>
    </form>
  );
}
