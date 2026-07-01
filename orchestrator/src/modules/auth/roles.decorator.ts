import { SetMetadata } from '@nestjs/common';
import type { Role } from './roles.enum';

export const ROLES_KEY = 'roles';
/** Attach to a controller method: `@Roles(Role.Operator)` — enforced by `RolesGuard`. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
