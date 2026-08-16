import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  modes: Array<"worker" | "staff">;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
