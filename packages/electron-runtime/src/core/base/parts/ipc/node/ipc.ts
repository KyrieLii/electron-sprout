/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Event } from '../../../common/event';
import { revive } from '../../../common/marshalling';
import { isUndefinedOrNull } from '../../../common/types';
import { isUpperAsciiLetter } from '../../../common/strings';
import { IServerChannel, IChannel } from '../common/ipc';

/**
 * Use both `createChannelReceiver` and `createChannelSender`
 * for automated process <=> process communication over methods
 * and events. You do not need to spell out each method on both
 * sides, a proxy will take care of this.
 *
 * Rules:
 * - if marshalling is enabled, only `URI` and `RegExp` is converted
 *   automatically for you
 * - events must follow the naming convention `onUppercase`
 * - `CancellationToken` is currently not supported
 * - if a context is provided, you can use `AddFirstParameterToFunctions`
 *   utility to signal this in the receiving side type
 */

export interface IBaseChannelOptions {
  /**
   * Disables automatic marshalling of `URI`.
   * If marshalling is disabled, `UriComponents`
   * must be used instead.
   */
  disableMarshalling?: boolean;
}

export type IChannelReceiverOptions = IBaseChannelOptions;

export function createChannelReceiver(
  service: unknown,
  options?: IChannelReceiverOptions,
): IServerChannel {
  const handler = service as { [key: string]: unknown };
  const disableMarshalling = options && options.disableMarshalling;

  // Buffer any event that should be supported by
  // iterating over all property keys and finding them
  const mapEventNameToEvent = new Map<string, Event<unknown>>();
  for (const key in handler) {
    if (propertyIsEvent(key)) {
      mapEventNameToEvent.set(
        key,
        Event.buffer(handler[key] as Event<unknown>, true),
      );
    }
  }

  const isPromise = (obj: any) =>
    Boolean(obj) &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    typeof obj.then === 'function';

  return new (class implements IServerChannel {
    listen<T>(_: unknown, event: string): Event<T> {
      const eventImpl = mapEventNameToEvent.get(event);
      if (eventImpl) {
        return eventImpl as Event<T>;
      }

      throw new Error(`Event not found: ${event}`);
    }

    call(_: unknown, command: string, args?: any[]): Promise<any> {
      const target = handler[command];
      if (typeof target === 'function') {
        // Revive unless marshalling disabled
        if (!disableMarshalling && Array.isArray(args)) {
          for (let i = 0; i < args.length; i++) {
            args[i] = revive(args[i]);
          }
        }
        try {
          const result = target.apply(handler, args);
          if (isPromise(result)) {
            return result;
          }
          return Promise.resolve(result);
        } catch (error) {
          return Promise.reject(error);
        }
      }

      throw new Error(`Method not found: ${command}`);
    }
  })();
}

export interface IChannelSenderOptions extends IBaseChannelOptions {
  /**
   * If provided, will add the value of `context`
   * to each method call to the target.
   */
  context?: unknown;
}

export function createChannelSender<T>(
  channel: IChannel,
  options?: IChannelSenderOptions,
): T {
  const disableMarshalling = options && options.disableMarshalling;

  return new Proxy(
    {},
    {
      get(_target: T, propKey: PropertyKey) {
        if (typeof propKey === 'string') {
          // Event
          // this will effect services which can't use name startWithOn
          // if (propertyIsEvent(propKey)) {
          //   return channel.listen(propKey);
          // }

          // Function
          return async function (...args: any[]) {
            // Add context if any
            let methodArgs: any[];
            if (options && !isUndefinedOrNull(options.context)) {
              methodArgs = [options.context, ...args];
            } else {
              methodArgs = args;
            }

            const result = await channel.call(propKey, methodArgs);

            // Revive unless marshalling disabled
            if (!disableMarshalling) {
              return revive(result);
            }

            return result;
          };
        }

        throw new Error(`Property not found: ${String(propKey)}`);
      },
    },
  ) as T;
}

function propertyIsEvent(name: string): boolean {
  // Assume a property is an event if it has a form of "onSomething"
  return (
    name.startsWith('o') &&
    name[1] === 'n' &&
    isUpperAsciiLetter(name.charCodeAt(2))
  );
}
