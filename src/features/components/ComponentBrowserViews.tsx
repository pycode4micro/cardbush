import type { CSSProperties } from 'react';
import { HomeWebsiteView } from './HomeWebsiteView';
import type { ComponentBrowser } from './componentBrowsers';

export function ComponentBrowserViews({items, status}: {items: ComponentBrowser[]; status:(item:ComponentBrowser, state:'loaded'|'failed')=>void}) {
  return items.map(item => <div key={item.id} className="component-browser-slot" data-component-browser={item.id}
    style={{'--browser-x':item.clipX+'px','--browser-y':item.clipY+'px',
      '--browser-width':item.clipWidth+'px','--browser-height':item.clipHeight+'px'} as CSSProperties}>
    <div className="component-browser-content" style={{'--browser-x':(item.x-item.clipX)+'px','--browser-y':(item.y-item.clipY)+'px',
      '--browser-width':item.width+'px','--browser-height':item.height+'px'} as CSSProperties}>
      <HomeWebsiteView key={item.url+':'+item.revision} url={item.url} status={state => status(item,state)}/>
    </div>
  </div>);
}
