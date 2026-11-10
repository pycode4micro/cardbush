import { createRoot } from 'react-dom/client';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import type { HtmlComponent } from './componentModel';
import '../../styles/theme.css';
import './components.css';

const api = (window as Window & {componentPreview?:{read():Promise<HtmlComponent>;ready():void}}).componentPreview;
if (api) void api.read().then(component => {
  createRoot(document.getElementById('root')!).render(<HtmlComponentSurface component={component} active={false}
    onReady={() => requestAnimationFrame(() => requestAnimationFrame(() => api.ready()))}/>);
});
