import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { ClaudeAccount, ClaudeAccountLogin, DiscoveredAccount } from "@yugotool/contracts";
import {
  ClaudeAccountDto,
  ClaudeAccountLoginCodeDto,
  ClaudeAccountLoginDto,
  CreateClaudeAccountDto,
  DiscoveredAccountDto,
  SetDefaultClaudeAccountDto,
  StartClaudeLoginDto,
} from "./claude-accounts.dto";
import { ClaudeAccountsService } from "./claude-accounts.service";
import { ClaudeLoginsService } from "./claude-logins.service";

@ApiTags("claude-accounts")
@Controller("claude-accounts")
export class ClaudeAccountsController {
  constructor(
    private readonly accounts: ClaudeAccountsService,
    private readonly logins: ClaudeLoginsService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [ClaudeAccountDto] })
  list(): Promise<ClaudeAccount[]> {
    return this.accounts.list();
  }

  /** `~/.claude` and `~/.claude-*` dirs on this machine, with who is signed in there. */
  @Get("discover")
  @ApiOkResponse({ type: [DiscoveredAccountDto] })
  discover(): Promise<DiscoveredAccount[]> {
    return this.accounts.discover();
  }

  /** Adds a signed-in config dir or an API key. New logins go through `logins`. */
  @Post()
  @ApiCreatedResponse({ type: ClaudeAccountDto })
  create(@Body() body: CreateClaudeAccountDto): Promise<ClaudeAccount> {
    return this.accounts.create(body);
  }

  @Put("default")
  @HttpCode(204)
  @ApiNoContentResponse()
  setDefault(@Body() body: SetDefaultClaudeAccountDto): Promise<void> {
    return this.accounts.setDefault(body.accountId);
  }

  /** A dir YugoTool created is deleted with it; any other dir is never touched. */
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.accounts.remove(id);
  }

  /** Starts `claude auth login`; poll `GET logins/:id` until it is done or failed. */
  @Post("logins")
  @ApiCreatedResponse({ type: ClaudeAccountLoginDto })
  startLogin(@Body() body: StartClaudeLoginDto): Promise<ClaudeAccountLogin> {
    return this.logins.start(body);
  }

  @Get("logins/:loginId")
  @ApiOkResponse({ type: ClaudeAccountLoginDto })
  login(@Param("loginId", ParseUUIDPipe) loginId: string): ClaudeAccountLogin {
    return this.logins.get(loginId);
  }

  /** The code from the manual link's page, when the browser did not finish by itself. */
  @Post("logins/:loginId/code")
  @HttpCode(200)
  @ApiOkResponse({ type: ClaudeAccountLoginDto })
  submitCode(
    @Param("loginId", ParseUUIDPipe) loginId: string,
    @Body() body: ClaudeAccountLoginCodeDto,
  ): ClaudeAccountLogin {
    return this.logins.submitCode(loginId, body.code);
  }

  @Delete("logins/:loginId")
  @HttpCode(204)
  @ApiNoContentResponse()
  cancelLogin(@Param("loginId", ParseUUIDPipe) loginId: string): void {
    this.logins.cancel(loginId);
  }
}
