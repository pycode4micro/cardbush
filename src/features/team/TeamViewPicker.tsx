import { uiText } from '../../i18n';
import { GitBranch, History } from 'lucide-react';
import type { DefinitionReceipt, TeamRun, TeamWorkflow } from '@cardbush/bush-protocol';
import { SettingsDropdown, type SettingsDropdownOption } from '../settings/SettingsDropdown';
import { teamStatusLabel } from './teamFlowGraph';

/** Use the shared keyboard-accessible picker, with compact selection and full run details. */
export function TeamViewPicker({ record, runs, run, language, disabled, onChange }: {
  record?: DefinitionReceipt<TeamWorkflow>; runs: TeamRun[]; run?: TeamRun; language: string; disabled?: boolean; onChange: (value: string) => void;
}) {
  const locale = language;
  const options: SettingsDropdownOption[] = record ? [{ value: 'definition', label: record.definition.name,
    selectedLabel: `${uiText(language)('teamViewPicker.currentWorkflow')} · v${record.revision}`, group: uiText(language)('teamViewPicker.currentWorkflow'),
    description: `${record.definition.nodes.length} ${uiText(language)('teamViewPicker.stepsEditable')} · v${record.revision}`, icon: <GitBranch size={15}/> }] : [];
  options.push(...runs.map(item => {
    const status = teamStatusLabel(item.status, language), date = new Date(item.createdAt);
    const timestamp = date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return { value: item.id, group: uiText(language)('teamViewPicker.runHistoryReadOnly'),
      label: <span className="team-run-option-title"><span data-status={item.status}>{status}</span><time dateTime={item.createdAt}>{timestamp}</time></span>,
      selectedLabel: `${status} · ${date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`,
      description: `v${item.teamRevision} · ${item.nodes.filter(node => node.status === 'completed').length}/${item.nodes.length} ${uiText(language)('teamViewPicker.steps')}${item.input ? ' · ' + item.input : ''}`,
      searchText: `${status} ${timestamp} ${item.input}`, icon: <History size={15}/> };
  }));
  return <SettingsDropdown label={uiText(language)('teamViewPicker.viewDefinitionOrRun')} value={run?.id ?? 'definition'} options={options} disabled={disabled} onChange={onChange} minMenuWidth={350}/>;
}
