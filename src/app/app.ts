import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Root shell — just hosts the router outlet; all UI lives in lazy routes. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
})
export class App {}
