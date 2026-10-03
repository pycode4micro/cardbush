import logo from '../../assets/model-logos/openai.svg';

export function ChatGptMark() {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 18, height: 18, flexShrink: 0,
    background: 'currentColor', mask: `url("${logo}") center / contain no-repeat` }}/>;
}
