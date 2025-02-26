import Board from "./board"
import PokemonEntity from "./pokemon-entity"
import PokemonState from "./pokemon-state"
import { PokemonActionState } from "../types/enum/Game"
import { Synergy } from "../types/enum/Synergy"
import { distanceC } from "../utils/distance"

export default class MovingState extends PokemonState {
  update(pokemon: PokemonEntity, dt: number, board: Board, weather: string) {
    super.update(pokemon, dt, board, weather)
    if (pokemon.cooldown <= 0) {
      pokemon.cooldown = 500
      const targetCoordinate = this.getNearestTargetCoordinate(pokemon, board)
      if (targetCoordinate) {
        const distance = distanceC(
          pokemon.positionX,
          pokemon.positionY,
          targetCoordinate.x,
          targetCoordinate.y
        )
        if (distance <= pokemon.range && !pokemon.status.charm) {
          pokemon.toAttackingState()
        } else if (distance > 1) {
          this.move(pokemon, board, targetCoordinate)
        }
      }
    } else {
      pokemon.cooldown = Math.max(0, pokemon.cooldown - dt)
    }
  }

  move(
    pokemon: PokemonEntity,
    board: Board,
    coordinates: { x: number; y: number }
  ) {
    //logger.debug('move attempt');

    let x: number | undefined = undefined
    let y: number | undefined = undefined
    if (pokemon.types.includes(Synergy.DARK) && pokemon.baseRange === 1) {
      const farthestCoordinate = this.getFarthestTargetCoordinateAvailablePlace(
        pokemon,
        board
      )
      //logger.debug({ farthestCoordinate })
      if (farthestCoordinate) {
        x = farthestCoordinate.x
        y = farthestCoordinate.y
      }
    } else {
      const cells = board.getAdjacentCells(pokemon.positionX, pokemon.positionY)
      let distance = 999

      cells.forEach((cell) => {
        if (cell.value === undefined) {
          const candidateDistance = distanceC(
            coordinates.x,
            coordinates.y,
            cell.x,
            cell.y
          )
          // logger.debug(`${pokemon.name} - Candidate (${cell.x},${cell.y}) to ${coordinates.x},${coordinates.y}, distance: ${candidateDistance}`);
          if (candidateDistance < distance) {
            distance = candidateDistance
            x = cell.x
            y = cell.y
          }
        }
      })
    }
    if (x !== undefined && y !== undefined) {
      pokemon.orientation = board.orientation(
        pokemon.positionX,
        pokemon.positionY,
        x,
        y,
        pokemon,
        undefined
      )
      // logger.debug(`pokemon ${pokemon.name} moved from (${pokemon.positionX},${pokemon.positionY}) to (${x},${y}), (desired direction (${coordinates.x}, ${coordinates.y})), orientation: ${pokemon.orientation}`);
      board.swapValue(pokemon.positionX, pokemon.positionY, x, y)
    }
  }

  onEnter(pokemon: PokemonEntity) {
    super.onEnter(pokemon)
    pokemon.action = PokemonActionState.WALK
  }

  onExit(pokemon: PokemonEntity) {
    super.onExit(pokemon)
  }
}
